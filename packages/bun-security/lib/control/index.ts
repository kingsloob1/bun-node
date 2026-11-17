/**
 * The control plane (`@kingsleyweb/bun-security/control`, control-plane.md):
 * the management API, the admin listener, bundle signing, inheritance and
 * dangerous-change checks. It runs only in the control plane, never on an
 * enforcement point. Its browser-safe contract is `./control/contract`.
 */
export { secureAdmin, isPrivateBind } from "./admin";
export type { AgentEventsOptions, AgentIdentity } from "./agentEvents";
export type { AdminListener, AdminMount, SecureAdminOptions } from "./admin";
export { createSecurityApi } from "./api";
export {
  agentGuard,
  agentRequest,
  checkAgentHeaders,
  sendSigned,
  verifyAgentBody,
} from "./agentRoutes";
export type {
  AgentRequest,
  AgentRequestOutcome,
  AgentRouteContext,
  HeaderState,
} from "./agentRoutes";
export { AgentRegistry } from "./agents";
export { directoryArtefacts, sha256Of } from "./artefacts";
export type { ArtefactStore } from "./artefacts";
export { auditHash } from "./audit/log";
export { totpCode } from "./audit/breakglass";
export type { BreakGlassOptions } from "./audit/breakglass";
export type { AuditSigning } from "./audit/keys";
export {
  callbackCheckpointSink,
  fileCheckpointSink,
  webhookCheckpointSink,
} from "./audit/sinks";
export type {
  CheckpointSink,
  WebhookCheckpointSinkOptions,
} from "./audit/sinks";
export type { SecurityApi } from "./api";
export { dangerousChanges } from "./dangerous";
export { diffPolicies, mergePolicies } from "./merge";
export type {
  LockedOverride,
  MergedPolicy,
  PolicyChange,
  PolicyLayer,
} from "./merge";
export type {
  Operator,
  PermissionTarget,
  ResolvedAgentsOptions,
  SecurityApiAgentsOptions,
  SecurityApiOptions,
  StepUpHook,
} from "./options";
export { ControlPlane } from "./plane";
export type { PublishOutcome, PublishRequest } from "./plane";
export { ApiProblem } from "./problems";
export { bundlePublicKey, signBundle } from "./signing";
export type { BundleSigner, ResolvedSigner } from "./signing";
