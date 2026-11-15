/**
 * `@kingsleyweb/bun-security`: the request-defence engine (plan §3.1).
 *
 * - {@link createSecurity}: the engine — `evaluate`, `explain`, `load`,
 *   `status`, `close` — decided locally from a compiled policy;
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
  type ExplainOptions,
  type Security,
  type SecurityStatus,
} from "./engine/security";
export type {
  SecurityWarning,
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
  DEFAULT_MAX_LIST_ENTRIES,
  DEFAULT_SERVICE_HEADER,
  securityPolicySchema,
} from "./policy/schema";
export type {
  InternalListPolicy,
  KeyPolicy,
  ListAction,
  ListEntry,
  PolicyScope,
  SecurityAction,
  SecurityMode,
  SecurityPolicy,
  ServiceExemption,
  ServiceIdentity,
  ServiceIdentityPolicy,
  TrustCheckPolicy,
} from "./policy/types";
