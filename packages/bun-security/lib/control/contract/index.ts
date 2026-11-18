/**
 * The management API's contract (`@kingsleyweb/bun-security/control/contract`):
 * its wire types, permission and role names, problem codes and constants.
 * Browser-safe, with no runtime import beyond its own modules and the rule
 * regex check (which imports nothing): the UI and typed clients import
 * this, never `./control`.
 */
export {
  AUDIT_INCOMPLETE_HEADER,
  BREAK_GLASS_HEADER,
  BUNDLE_FORMAT,
  DEFAULT_API_PAGE_LIMIT,
  DEFAULT_SECURITY_CSRF_HEADER,
  MAX_API_PAGE_LIMIT,
  MAX_GROUP_DEPTH,
  ROLE_PERMISSIONS,
  SECURITY_API_ERROR_CODES,
  SECURITY_API_PERMISSIONS,
  SECURITY_ALERT_KINDS,
  SECURITY_API_PROTOCOL_VERSION,
  SECURITY_LIVE_EVENTS,
  SECURITY_ROLES,
} from "./constants";
export type {
  SecurityAlertKind,
  SecurityApiErrorCode,
  SecurityApiPermission,
  SecurityLiveEventName,
  SecurityRole,
} from "./constants";
export type {
  ApprovalDecisionInput,
  AuditActorDto,
  AuditCheckpointDto,
  AuditEntryDto,
  AuditProblemDto,
  AuditTargetDto,
  AuditVerifyDto,
  BreakGlassLoginInput,
  BreakGlassSessionDto,
  AgentCreateInput,
  AgentDto,
  AgentSecretDto,
  AgentStatus,
  ApprovalDto,
  BanCreateInput,
  BanDto,
  CompiledBundleDto,
  EffectivePolicyDto,
  EnteredListEntryDto,
  GroupDto,
  GroupInput,
  OperatorDto,
  PageDto,
  PolicyChangeDto,
  PolicyDiffDto,
  PolicyDraftDto,
  PolicyDraftInput,
  PolicyDto,
  PolicyScopeId,
  PolicyVersionDto,
  ProblemDto,
  PublishInput,
  PublishResultDto,
  RoleBindingDto,
  RoleBindingInput,
  RollbackInput,
  SecurityAlertDto,
  SecurityApiMetaDto,
  SecurityApiPermissionsDto,
  SecurityLiveEventDto,
  ServiceDto,
  ServiceIdentityDto,
  ServiceIdentityInput,
  ServiceInput,
} from "./types";
export { DRAFT_EFFECT_LIMITS } from "./draftEffect";
export type { DraftEffectDto, DraftServiceEffectDto } from "./draftEffect";
export {
  ANALYTICS_READ_LIMITS,
  LIVE_CLOSE_CODES,
  LIVE_LIMITS,
  LIVE_TOPIC_KINDS,
} from "./live";
export type {
  AnalyticsPointDto,
  AnalyticsScope,
  AnalyticsTopRowDto,
  BanTimelineDto,
  LiveBanMessageDto,
  LiveControlMessageDto,
  LiveCursorDto,
  LiveEventMessageDto,
  LiveGapDto,
  LiveMoreDto,
  LiveOverviewDto,
  LiveSubscribedDto,
  LiveTopicKind,
  SecurityEventViewDto,
} from "./live";
export { ALERT_API_LIMITS, ALERT_SEVERITIES } from "./alerts";
export type {
  AlertChannelCreateInput,
  AlertChannelDto,
  AlertChannelReceives,
  AlertChannelSecretDto,
  AlertChannelUpdateInput,
  AlertCondition,
  AlertDeadLetterDto,
  AlertDeliveryLogDto,
  AlertMetric,
  AlertRuleDto,
  AlertRuleInput,
  AlertSeverity,
  OpenAlertDto,
} from "./alerts";
export { RULE_TEST_LIMITS } from "./ruleTest";
// A rule's regex verdict, for an editor checking as the operator types
// (PR-U5): the same check the control plane runs; it imports nothing.
export {
  MAX_REGEX_LENGTH,
  MAX_REGEX_REPEAT,
  regexRefusal,
} from "../../rules/regex";
export type {
  ImpactRuleDto,
  ImpactTransitionDto,
  RuleEvaluability,
  RuleImpactDto,
  RuleImpactInput,
  RuleLabelDto,
  RuleTestAction,
  RuleTestHitDto,
  RuleTestHopDto,
  RuleTestInput,
  RuleTestResultDto,
  RuleTestStepDto,
} from "./ruleTest";
