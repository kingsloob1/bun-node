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
 * `hardenServe`); `./http` is the bun-common integration; `./stores` the
 * shared store over bun-cache (`cacheStore`, `hybridThrottleStore`).
 */
export { ACTION_SEVERITY } from "./engine/actions";
export type {
  ApiKeyAnomalyAction,
  ApiKeyAnomalyPolicy,
  ApiKeysPolicy,
} from "./apikeys/policy";
export type { CrawlerConflict } from "./crawlers/conflicts";
export {
  CRAWLER_EXEMPTIONS,
  type CrawlerExemption,
  type CrawlersPolicy,
  type CrawlerVerifyMethod,
  type CustomCrawler,
} from "./crawlers/policy";
export {
  CRAWLER_IDS,
  CRAWLERS,
  type CrawlerDefinition,
  type CrawlerId,
  DEFAULT_CRAWLERS,
} from "./crawlers/registry";
export type { CrawlerResolver } from "./crawlers/verify";
export type { Ban, BanSubject } from "./engine/bans";
export type {
  ClientResolution,
  ClientSource,
  Decision,
  DecisionCrawler,
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
  DEFAULT_TRAP_FIELD,
  isTrapFilled,
  trapField,
  type TrapField,
  type TrapFieldOptions,
  type TrapSubmission,
} from "./engine/deception";
export { canonicalPath } from "./engine/path";
export {
  type BanInput,
  createSecurity,
  type CreateSecurityOptions,
  type EvaluateOptions,
  type KeyCompromise,
  type RevokeApiKeyOptions,
  type ExplainOptions,
  type MessageDecision,
  type RequestOutcome,
  type Security,
  type SecurityStatus,
  type SharedStoreStatus,
  type SignalData,
  type SocketLimiter,
  type StateStatus,
  type UnbanOptions,
} from "./engine/security";
export type {
  SharedStateIntervals,
  SharedStateStore,
  StoreHealth,
} from "./engine/shared";
export type { EvaluationStage } from "./engine/stages";
export {
  BOT_SIGNALS,
  type BotSignalName,
  type BotSignalsPolicy,
} from "./engine/signals";
export {
  DETECTOR_PRESETS,
  PRESET_IDS,
  PRESETS,
  PROFILE_NAMES,
  type Preset,
} from "./policy/presets";
export type { FailureRateState } from "./sensitive/failureRate";
export type { CheckKind } from "./sensitive/identifiers";
export { DEFAULT_DEVICE_COOKIE } from "./sensitive/keys";
export { SecurityRefusal } from "./sensitive/refusal";
export { DEFAULT_MAX_KEYS } from "./engine/state";
export { DEFAULT_MAX_REGEX_INPUT } from "./rules/compile";
export { MANAGED_RULE_IDS } from "./rules/managed";
export { regexRefusal } from "./rules/regex";
export type {
  AddressMatcher,
  AsnMatcher,
  ManagedRuleId,
  ManagedRulesPolicy,
  NumberMatcher,
  RequestRule,
  RequestRuleAction,
  RequestRulesPolicy,
  RuleCondition,
  RuleMatch,
  StringMatcher,
} from "./rules/types";
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
export {
  type PolicyIssue,
  type PolicyIssueCode,
  SecurityPolicyError,
} from "./policy/errors";
export { DEFAULT_HONEYPOTS, DEFAULT_WEIGHTS } from "./policy/compile";
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
  BanPolicy,
  CanaryPolicy,
  ConcurrencyPolicy,
  CountedRule,
  CountedRuleAction,
  DeceptionPolicy,
  HoneypotPolicy,
  InternalListPolicy,
  KeyPolicy,
  LadderPolicy,
  LadderStep,
  LimitAlgorithm,
  IdentifierKind,
  IdentifierPattern,
  IdentifierPolicy,
  LimitRule,
  ListAction,
  FailureRatePolicy,
  FailureRateTarget,
  LoginProfilePolicy,
  MessagePolicy,
  ProfilesPolicy,
  ListEntry,
  PolicyScope,
  PresetSetting,
  SecurityAction,
  SecurityMode,
  SecurityPolicy,
  ServiceExemption,
  ServiceIdentity,
  ServiceIdentityPolicy,
  ShapePolicy,
  ShapeRoute,
  StateMode,
  StatePolicy,
  StoreErrorMode,
  SubjectKeyPart,
  TrustCheckPolicy,
} from "./policy/types";
export {
  bundleSigningBytes,
  canonicalJson,
  verifyBundle,
} from "./bundle/index";
export type {
  BundleArtefact,
  BundlePublicKey,
  BundleRefusal,
  BundleSignature,
  BundleVerdict,
  SecurityBundle,
  VerifyBundleOptions,
} from "./bundle/index";
