/**
 * The live hub's and the analytics reads' contract (ui.md §6, §7, PR-CP5):
 * topics, limits, close codes and the messages, browser-safe and free of
 * runtime imports, so the UI and typed clients read the same names.
 */
import type { BanDto, PolicyScopeId, SecurityLiveEventDto } from "./types";

/**
 * The live topics a subscription names, each as `<kind>:<scope>` (`events:
 * group:payments`) except `approvals`, which is unscoped.
 */
export const LIVE_TOPIC_KINDS = /* @__PURE__ */ Object.freeze([
  "overview",
  "events",
  "bans",
  "policy",
  "approvals",
] as const);

/** A live topic's kind. */
export type LiveTopicKind = (typeof LIVE_TOPIC_KINDS)[number];

/** The live hub's bounds (ui.md §6; the user's defaults of 2026-11-17). */
export const LIVE_LIMITS = /* @__PURE__ */ Object.freeze({
  /** Live connections one operator may hold at once. */
  connectionsPerOperator: 5,
  /** Topics one connection may subscribe to. */
  topicsPerConnection: 10,
  /** Activity-feed events a subscriber is sent a second; the rest are counted. */
  eventsPerSecond: 20,
  /** More a second for priority events (`ban`, `drop`) past that. */
  priorityPerSecond: 20,
  /** Messages the resume ring holds. */
  ringMessages: 1_000,
  /** The oldest message the resume ring holds, ms. */
  ringAgeMs: 300_000,
  /** Bytes buffered for a subscriber past which it gets a `gap` and is told to refetch. */
  slowBytes: 1_048_576,
  /** Bytes buffered under which a slow subscriber is resumed. */
  recoverBytes: 262_144,
});

/** The analytics reads' bounds (the user's defaults of 2026-11-17). */
export const ANALYTICS_READ_LIMITS = /* @__PURE__ */ Object.freeze({
  /** The longest range a read spans, ms (400 days). */
  rangeMs: 400 * 86_400_000,
  /** The most points a series answers. */
  seriesPoints: 10_000,
  /** The largest top-N. */
  topN: 100,
  /** The largest page of events. */
  eventsPage: 200,
});

/** The close codes the live channel uses. */
export const LIVE_CLOSE_CODES = /* @__PURE__ */ Object.freeze({
  /** The operator's access to a subscribed topic changed: re-subscribe. */
  accessChanged: 4403,
  /** Past the per-operator connection limit. */
  limit: 4429,
  /** The control plane is shutting down. */
  shutdown: 1001,
});

/**
 * An event as a subscriber or a reader sees it. Under `analytics:read`
 * alone: its time, service, route, action, rule, dry run, country, ASN and
 * address, never its request sample or its user, username or API-key
 * subjects. Under `events:read`: the whole event (on the live stream,
 * still never the sample: the detail view fetches it by id).
 */
export interface SecurityEventViewDto {
  /** Its id. */
  readonly id: string;
  /** When it was decided, epoch milliseconds. */
  readonly at: number;
  /** The service that decided it. */
  readonly service: string;
  /** The action taken. */
  readonly action: string;
  /** The deciding rule. */
  readonly rule?: string;
  /** Every rule hit. */
  readonly rules?: readonly string[];
  /** Whether the deciding hit was in dry run. */
  readonly dryRun?: boolean;
  /** The route's key. */
  readonly route?: string;
  /** The subjects: the address always; the others under `events:read`. */
  readonly subjects?: {
    /** The address key. */
    readonly ip?: string;
    /** The user's key (`events:read`). */
    readonly user?: string;
    /** The API key's HMAC (`events:read`). */
    readonly apiKey?: string;
    /** The attempted username's HMAC (`events:read`). */
    readonly username?: string;
  };
  /** The client's country. */
  readonly country?: string;
  /** The client's autonomous system. */
  readonly asn?: number;
  /** The decision's latency, ms. */
  readonly latencyMs?: number;
  /** The answer's status. */
  readonly status?: number;
  /** The redacted request (`events:read`, the REST reads only). */
  readonly sample?: unknown;
}

/** A ban written or lifted, on a `bans:<scope>` topic: the record as the store holds it. */
export interface LiveBanMessageDto {
  /** The topic. */
  readonly topic: string;
  /** The hub's epoch. */
  readonly epoch: string;
  /** Its sequence number. */
  readonly seq: number;
  /** The ban, its subject as stored. */
  readonly ban: BanDto;
}

/** The ban timeline: bans created and lifted per bucket, by source, and how many are active now. */
export interface BanTimelineDto {
  /** The bucket's width, ms. */
  readonly bucketMs: number;
  /** One point per bucket with a ban created or lifted in it. */
  readonly points: readonly {
    /** The bucket's start. */
    readonly at: number;
    /** Bans created in it, by source (`auto`, `manual`). */
    readonly created: Readonly<Record<string, number>>;
    /** Bans lifted in it. */
    readonly lifted: number;
  }[];
  /** Bans in force now. */
  readonly active: number;
  /** Whether the scope held more bans than one read scans (the counts are then a lower bound). */
  readonly truncated: boolean;
}

/** A resume point: the hub's epoch and the last sequence number received. */
export interface LiveCursorDto {
  /** The hub's epoch (one per control-plane instance's life). */
  readonly epoch: string;
  /** The last sequence number received. */
  readonly seq: number;
}

/** A live activity-feed event. */
export interface LiveEventMessageDto {
  /** The topic it was sent for. */
  readonly topic: string;
  /** The hub's epoch. */
  readonly epoch: string;
  /** Its sequence number. */
  readonly seq: number;
  /** The event, as the subscriber may see it. */
  readonly event: SecurityEventViewDto;
}

/** A second's counters for an `overview` topic: deltas, by action. */
export interface LiveOverviewDto {
  /** The topic. */
  readonly topic: string;
  /** The second, epoch milliseconds. */
  readonly at: number;
  /** Requests decided in it, by action. */
  readonly requests: Readonly<Record<string, number>>;
}

/** Events past a subscriber's rate in the last second, counted. */
export interface LiveMoreDto {
  /** The topic. */
  readonly topic: string;
  /** The second, epoch milliseconds. */
  readonly at: number;
  /** How many were not sent. */
  readonly count: number;
}

/** Messages were missed: refetch what is shown, then carry on from here. */
export interface LiveGapDto {
  /** Why: a resume point the ring no longer holds (`resume`), or a subscriber too slow to keep up (`slow`). */
  readonly reason: "resume" | "slow";
  /** The hub's epoch. */
  readonly epoch: string;
  /** The sequence number to carry on from. */
  readonly seq: number;
}

/** A policy, bundle, approval or break-glass event, as CP2 sent it, with its place in the stream. */
export interface LiveControlMessageDto extends SecurityLiveEventDto {
  /** The topic it was sent for (`policy:<scope>`, `approvals`; absent on the unscoped stream). */
  readonly topic?: string;
  /** The hub's epoch. */
  readonly epoch: string;
  /** Its sequence number. */
  readonly seq: number;
}

/** What a channel's `subscribe` answers. */
export interface LiveSubscribedDto {
  /** The topics subscribed now. */
  readonly topics: readonly string[];
  /** Topics refused, and why (`forbidden`, `invalid`, `limit`). */
  readonly refused: readonly {
    /** The topic. */
    readonly topic: string;
    /** Why. */
    readonly reason: "forbidden" | "invalid" | "limit";
  }[];
  /** The hub's epoch and its last sequence number. */
  readonly epoch: string;
  /** The hub's last sequence number. */
  readonly seq: number;
}

/** A metric's point, as `GET /analytics/series` answers it. */
export interface AnalyticsPointDto {
  /** The bucket's start, epoch milliseconds. */
  readonly at: number;
  /** The row's dimensions. */
  readonly dims: Readonly<Record<string, string>>;
  /** The sum. */
  readonly value: number;
}

/** A top-N row, as `GET /analytics/top` answers it. */
export interface AnalyticsTopRowDto {
  /** The dimensions. */
  readonly dims: Readonly<Record<string, string>>;
  /** The sum over the range. */
  readonly value: number;
}

/** A scope id or `global`, for the analytics reads. */
export type AnalyticsScope = PolicyScopeId;
