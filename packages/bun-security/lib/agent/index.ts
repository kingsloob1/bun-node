/**
 * `@kingsleyweb/bun-security/agent` (control-plane.md §7, PR-CP4): the
 * service side of the control plane: `connectAgent` keeps an engine on the
 * service's signed bundle and the control plane's signed bans, with a last
 * known good on disk, heartbeats, the nudge and the event batcher. It never
 * loads the control plane's own code.
 */
export { AGENT_PROTOCOL_VERSION, connectAgent } from "./connect";
export type {
  AgentAlert,
  AgentArtefact,
  AgentEngine,
  AgentStatusReport,
  ConnectAgentOptions,
  SecurityAgent,
} from "./connect";
export { createEventBatcher } from "./batcher";
export type { BatchAnswer, EventBatcher, EventBatcherOptions } from "./batcher";
export {
  EVENT_BATCH_FORMAT,
  EVENT_BATCH_LIMITS,
  MAX_BATCH_COUNTERS,
  MAX_BATCH_EVENTS,
} from "./events";
export type {
  AgentEventBatch,
  AgentEventSource,
  CounterRow,
  SecurityEvent,
} from "./events";
export {
  AGENT_HEADER,
  AGENT_ID_PATTERN,
  AGENT_REQUEST_ID_HEADER,
  AGENT_ROUTES,
  AGENT_SIGNATURE_HEADER,
  AGENT_SIGNATURE_WINDOW_MS,
  agentRequestId,
  BAN_REPORT_LIMITS,
  MAX_BAN_REPORTS,
  MAX_HEARTBEAT_CONFLICTS,
  MAX_HEARTBEAT_FEEDS,
  MAX_HEARTBEAT_WARNINGS,
} from "./protocol";
export type {
  AgentBanReport,
  AgentBanReportAnswer,
  AgentBanReportBatch,
  AgentCrawlerConflict,
  AgentHeartbeat,
  AgentHeartbeatAnswer,
  AgentNudge,
  AgentNudgeEvent,
  AgentReportedHealth,
  AgentRoute,
  AgentFeedStatus,
  AgentWarning,
} from "./protocol";
export { AGENT_STATE_FORMAT } from "./state";
export type { AgentState } from "./state";
