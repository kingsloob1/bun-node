/**
 * `@kingsleyweb/bun-security`: the request-defence engine (plan §3.1).
 *
 * - {@link createSecurity}: the engine — `evaluate`, `explain`, `complete`,
 *   `signal`, `load`, `status`, `close` — decided locally from a compiled
 *   policy, with rate limits on bun-common's throttle foundation;
 * - {@link compilePolicy} and {@link securityPolicySchema}: the policy format,
 *   validated and compiled once;
 * - {@link requestFacts}: a web-standard request turned into the facts the
 *   engine decides from.
 *
 * `./serve` wraps a plain `Bun.serve` handler (`withSecurity`,
 * `hardenServe`).
 */
export { ACTION_SEVERITY } from "./engine/actions";
export type {
  ClientResolution,
  ClientSource,
  Decision,
  Explanation,
  ExplainStep,
  RuleHit,
  SecurityLayer,
  SubjectKeys,
} from "./engine/decision";
export {
  MAX_FACT_HEADER_LENGTH,
  MAX_FACT_HEADERS,
  type RequestFacts,
  requestFacts,
  type RequestFactsInit,
  type SecurityIdentity,
} from "./engine/facts";
export {
  createSecurity,
  type CreateSecurityOptions,
  type EvaluateOptions,
  type ExplainOptions,
  type RequestOutcome,
  type Security,
  type SecurityStatus,
  type StateStatus,
} from "./engine/security";
export { DEFAULT_MAX_KEYS } from "./engine/state";
export type {
  SecurityWarning,
  SecurityWarningKind,
  TrustMinute,
  TrustStatus,
  TrustWarningKind,
} from "./engine/trust";
export {
  type CompiledPolicy,
  compilePolicy,
  type CompilePolicyOptions,
} from "./policy/compile";
export { type PolicyIssue, SecurityPolicyError } from "./policy/errors";
export { INTERNAL_RANGES } from "./policy/internal";
export {
  DEFAULT_CLIENT_IP_HEADER,
  DEFAULT_CONCURRENCY_PER_IP,
  DEFAULT_MAX_LIST_ENTRIES,
  DEFAULT_SERVICE_HEADER,
  SECURITY_POLICY_VERSION,
  securityPolicySchema,
} from "./policy/schema";
export type {
  ConcurrencyPolicy,
  CountedRule,
  CountedRuleAction,
  InternalListPolicy,
  KeyPolicy,
  LimitAlgorithm,
  LimitRule,
  ListAction,
  ListEntry,
  PolicyScope,
  SecurityAction,
  SecurityMode,
  SecurityPolicy,
  ServiceExemption,
  ServiceIdentity,
  ServiceIdentityPolicy,
  SubjectKeyPart,
  TrustCheckPolicy,
} from "./policy/types";
