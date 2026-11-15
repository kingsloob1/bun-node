/**
 * What the engine answers (plan §4.1): a decision, every rule hit that led
 * to it, and the subject it was keyed on; and, from `explain()`, the steps
 * that produced it.
 */
import type { ProxyChainEntry } from "@kingsleyweb/bun-common";
import type { SecurityAction } from "../policy/types";

/** The defence layers of layers.md, in request order. */
export type SecurityLayer =
  | "L1"
  | "L2"
  | "L3"
  | "L4"
  | "L5"
  | "L6"
  | "L7"
  | "L8"
  | "L9"
  | "L10"
  | "L11"
  | "L12"
  | "L13"
  | "L14";

/** One rule or list entry that matched the request. */
export interface RuleHit {
  /** The layer it belongs to. */
  readonly layer: SecurityLayer;
  /** The rule's or entry's id (`ip:203.0.113.0/24`, `internal:10.0.0.0/8`, `service:pay-api`). */
  readonly rule: string;
  /** What it did: `log` for a dry-run hit. */
  readonly action: SecurityAction;
  /** In dry run, the action it would have taken (layers.md §0.4). */
  readonly wouldHaveBeen?: SecurityAction;
  /** Why, for operators and events; never sent to the client. */
  readonly reason?: string;
}

/**
 * The keys a request is counted, banned and reported under (layers.md
 * L2.3). A verified service call that forwards no believed end-user address
 * has no `ip`: it counts against nobody (L2.4).
 */
export interface SubjectKeys {
  /** The client's address, normalised (`::ffff:a.b.c.d` as `a.b.c.d`). */
  readonly address?: string;
  /** The address key: IPv4 as itself, IPv6 as its `/64` (the policy's prefix). */
  readonly ip?: string;
  /** The user id, from `identify()`. */
  readonly user?: string;
  /** The session id, from `identify()`. */
  readonly session?: string;
  /** The tenant, from `identify()`. */
  readonly tenant?: string;
  /** The API key id, from `identify()`. */
  readonly apiKey?: string;
  /** The verified calling service, for a service-identity call. */
  readonly service?: string;
}

/** The engine's answer for one request. */
export interface Decision {
  /** What to do: the most severe action of the enforced hits; `log` when only dry-run hits matched. */
  readonly action: SecurityAction;
  /** The status a refusal answers with (`403`), when it answers. */
  readonly status?: number;
  /** The problem code a refusal answers with (`"blocked"`); never names the rule. */
  readonly code?: string;
  /** For `delay`, how long. */
  readonly delayMs?: number;
  /** For a refusal that ends, the seconds until it does (`Retry-After`). */
  readonly retryAfter?: number;
  /** Every hit, in the order the layers ran. */
  readonly hits: readonly RuleHit[];
  /** Tags for the app (`req.security.tags`). */
  readonly tags: readonly string[];
  /**
   * The request's offence weight: the number of enforced refusing hits
   * until rules carry weights (layers.md §0.2).
   */
  readonly risk: number;
  /** The keys the request was decided under. */
  readonly subject: SubjectKeys;
}

/** Where the client's address came from. */
export type ClientSource =
  "socket" | "trusted-proxy" | "client-ip-header" | "service" | "none";

/** How the client was resolved, for `explain()` (layers.md L2.2 item 5). */
export interface ClientResolution {
  /** The address decided on, normalised; absent when the request counts against nobody. */
  readonly address?: string;
  /** Its key. */
  readonly key?: string;
  /** Where it came from. */
  readonly source: ClientSource;
  /** The trusted-proxy chain read, closest first. */
  readonly chain: readonly ProxyChainEntry[];
  /** The verified calling service, if any. */
  readonly service?: string;
}

/** One step of an explanation. */
export interface ExplainStep {
  /** The layer. */
  readonly layer: SecurityLayer;
  /** The check (`client`, `service-identity`, `list`). */
  readonly check: string;
  /** The rule or entry concerned, when one is. */
  readonly rule?: string;
  /** What happened, in a sentence. */
  readonly outcome: string;
  /** Whether this step decided the request's list outcome. */
  readonly decided?: boolean;
}

/** `explain()`'s answer: the decision `evaluate()` would give, and why. */
export interface Explanation {
  /** The decision, identical to `evaluate()`'s for the same facts and time. */
  readonly decision: Decision;
  /** How the client was resolved. */
  readonly client: ClientResolution;
  /** Every check, in order. */
  readonly steps: readonly ExplainStep[];
}
