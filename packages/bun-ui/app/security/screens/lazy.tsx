/** The screens loaded on demand (the kit's `onDemand`): the first load carries the shell and the analytics page's frame. */
import { onDemand } from "../../kit/onDemand";

/** `/api`, on demand: the reference viewer is the largest part of the app. */
export const ApiReferenceScreen = onDemand(
  async () => (await import("./ApiReference")).ApiReference,
  "Loading the API reference",
);

/** Props of a screen of a scope. */
interface ScopeProps {
  /** The scope on screen. */
  scope: string;
}

/** `/bans`, on demand. */
export const BansScreen = onDemand<ScopeProps>(
  async () => (await import("./bans/BansScreen")).BansScreen,
  "Loading the bans",
);

/** `/bans/new`, on demand. */
export const BanNewScreen = onDemand<ScopeProps>(
  async () => (await import("./bans/BanNew")).BanNew,
  "Loading the ban form",
);

/** `/bans/:id`, on demand. */
export const BanDetailScreen = onDemand<ScopeProps>(
  async () => (await import("./bans/BanDetail")).BanDetail,
  "Loading the ban",
);

/** `/bans/auto`, on demand. */
export const AutoBansScreen = onDemand<ScopeProps>(
  async () => (await import("./bans/AutoBans")).AutoBans,
  "Loading the automatic bans",
);

/** `/lists`, on demand. */
export const ListsScreen = onDemand<ScopeProps>(
  async () => (await import("./lists/ListsScreen")).ListsScreen,
  "Loading the lists",
);

/** `/lists/new`, on demand. */
export const ListEntryNewScreen = onDemand<ScopeProps>(
  async () => (await import("./lists/ListEntryNew")).ListEntryNew,
  "Loading the list-entry form",
);

/** `/events` and `/events/:id`, on demand. */
export const EventsScreen = onDemand<ScopeProps>(
  async () => (await import("./events/EventsScreen")).EventsScreen,
  "Loading the events",
);

/** `/services`, on demand. */
export const ServicesScreen = onDemand<ScopeProps>(
  async () => (await import("./services/ServicesScreen")).ServicesScreen,
  "Loading the services",
);

/** `/services/new` and `/services/:id`, on demand. */
export const ServiceFormScreen = onDemand<ScopeProps>(
  async () => (await import("./services/ServiceForm")).ServiceForm,
  "Loading the service",
);

/** `/groups`, on demand. */
export const GroupsScreen = onDemand<ScopeProps>(
  async () => (await import("./services/GroupsScreen")).GroupsScreen,
  "Loading the groups",
);

/** `/policies`, on demand. */
export const PolicyEditorScreen = onDemand<ScopeProps>(
  async () => (await import("./policies/PolicyEditor")).PolicyEditor,
  "Loading the policy",
);

/** `/policies/versions`, on demand. */
export const VersionsScreen = onDemand<ScopeProps>(
  async () => (await import("./policies/VersionsScreen")).VersionsScreen,
  "Loading the versions",
);

/** `/audit`, on demand. */
export const AuditScreen = onDemand<ScopeProps>(
  async () => (await import("./audit/AuditScreen")).AuditScreen,
  "Loading the audit log",
);

/** `/audit/:n`, on demand. */
export const AuditEntryScreen = onDemand<ScopeProps>(
  async () => (await import("./audit/AuditEntry")).AuditEntry,
  "Loading the audit entry",
);

/** `/agents`, on demand. */
export const AgentsScreen = onDemand<ScopeProps>(
  async () => (await import("./agents/AgentsScreen")).AgentsScreen,
  "Loading the agents",
);

/** `/agents/new`, on demand. */
export const AgentNewScreen = onDemand<ScopeProps>(
  async () => (await import("./agents/AgentNew")).AgentNew,
  "Loading the agent form",
);

/** `/agents/:id`, on demand. */
export const AgentDetailScreen = onDemand<ScopeProps>(
  async () => (await import("./agents/AgentDetail")).AgentDetail,
  "Loading the agent",
);

/** `/alerts` and its tabs, on demand. */
export const AlertsScreen = onDemand<ScopeProps>(
  async () => (await import("./alerts/AlertsScreen")).AlertsScreen,
  "Loading the alerts",
);

/** `/approvals`, on demand. */
export const ApprovalsScreen = onDemand<ScopeProps>(
  async () => (await import("./approvals/ApprovalsScreen")).ApprovalsScreen,
  "Loading the approvals",
);

/** `/approvals/:id`, on demand. */
export const ApprovalDetailScreen = onDemand<ScopeProps>(
  async () => (await import("./approvals/ApprovalDetail")).ApprovalDetail,
  "Loading the approval",
);

/** `/rules`, on demand. */
export const RulesScreen = onDemand<ScopeProps>(
  async () => (await import("./rules/RulesScreen")).RulesScreen,
  "Loading the request rules",
);

/** `/rules/new` and `/rules/edit/:id`, on demand. */
export const RuleEditScreen = onDemand<ScopeProps>(
  async () => (await import("./rules/RuleEdit")).RuleEdit,
  "Loading the rule editor",
);

/** `/rules/test`, on demand. */
export const RuleTestScreen = onDemand<ScopeProps>(
  async () => (await import("./rules/RuleTest")).RuleTest,
  "Loading test a request",
);
