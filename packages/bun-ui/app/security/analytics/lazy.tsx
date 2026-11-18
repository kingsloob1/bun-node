/** The analytics panels, each a chunk loaded on demand (ui.md §7: "each component a lazy chunk", PR-U2). */
import { onDemand } from "../../kit/onDemand";
import type { TopOffendersProps } from "./panels/TopOffenders";
import type { HeadlineProps } from "./panels/Headline";

/** Headline totals. */
export const HeadlinePanel = onDemand<HeadlineProps>(
  async () => (await import("./panels/Headline")).Headline,
  "Loading the headline",
);
/** Traffic over time. */
export const TrafficPanel = onDemand(
  async () => (await import("./panels/Traffic")).Traffic,
  "Loading traffic",
);
/** The outcome mix. */
export const OutcomeMixPanel = onDemand(
  async () => (await import("./panels/OutcomeMix")).OutcomeMix,
  "Loading the outcome mix",
);
/** Top offenders. */
export const TopOffendersPanel = onDemand<TopOffendersProps>(
  async () => (await import("./panels/TopOffenders")).TopOffenders,
  "Loading top offenders",
);
/** Per-rule hits. */
export const RuleHitsPanel = onDemand(
  async () => (await import("./panels/RuleHits")).RuleHits,
  "Loading rule hits",
);
/** Services and routes. */
export const ServicesRoutesPanel = onDemand(
  async () => (await import("./panels/ServicesRoutes")).ServicesRoutes,
  "Loading services",
);
/** Geography and ASN. */
export const GeographyPanel = onDemand(
  async () => (await import("./panels/Geography")).Geography,
  "Loading geography",
);
/** The ban timeline. */
export const BanTimelinePanel = onDemand(
  async () => (await import("./panels/BanTimeline")).BanTimeline,
  "Loading the ban timeline",
);
/** The activity feed. */
export const ActivityFeedPanel = onDemand(
  async () => (await import("./panels/ActivityFeed")).ActivityFeed,
  "Loading the activity feed",
);
/** Credential stuffing. */
export const CredentialStuffingPanel = onDemand(
  async () => (await import("./panels/CredentialStuffing")).CredentialStuffing,
  "Loading sign-in figures",
);
/** Agent health. */
export const AgentHealthPanel = onDemand(
  async () => (await import("./panels/AgentHealth")).AgentHealth,
  "Loading agent health",
);
/** Identifier patterns. */
export const PatternsPanel = onDemand(
  async () => (await import("./panels/Patterns")).Patterns,
  "Loading patterns",
);
/** IP-intel sources. */
export const IntelSourcesPanel = onDemand(
  async () => (await import("./panels/IntelSources")).IntelSources,
  "Loading IP-intel sources",
);

/** Every panel's loader, for the tests' preload. */
export const PANEL_LOADERS = [
  () => import("./panels/Headline"),
  () => import("./panels/Traffic"),
  () => import("./panels/OutcomeMix"),
  () => import("./panels/TopOffenders"),
  () => import("./panels/RuleHits"),
  () => import("./panels/ServicesRoutes"),
  () => import("./panels/Geography"),
  () => import("./panels/BanTimeline"),
  () => import("./panels/ActivityFeed"),
  () => import("./panels/CredentialStuffing"),
  () => import("./panels/AgentHealth"),
  () => import("./panels/Patterns"),
  () => import("./panels/IntelSources"),
] as const;
