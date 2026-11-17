/**
 * The analytics reads' and the live stream's schemas (PR-CP5): what
 * `GET /analytics/*` takes and answers, and what `/live` sends, in the
 * management API's documents.
 */
import type {
  AnalyticsPointDto,
  BanTimelineDto,
  LiveBanMessageDto,
  AnalyticsTopRowDto,
  LiveControlMessageDto,
  LiveEventMessageDto,
  LiveGapDto,
  LiveMoreDto,
  LiveOverviewDto,
  LiveSubscribedDto,
  SecurityEventViewDto,
} from "./contract/live";
import type { Schema } from "./schema";
import { ANALYTICS_READ_LIMITS, LIVE_LIMITS } from "./contract/live";
import { s } from "./schema";
import { Ban } from "./schemas";

/** A scope id. */
const Scope = s.string({
  min: 1,
  max: 80,
  pattern: /^(?:global|(?:group|service):[a-z\d][\w.-]{0,63})$/i,
  description: "global, group:<id> or service:<id>",
});

/** A metric's name. */
const Metric = s.string({
  min: 1,
  max: 100,
  pattern: /^[a-z0-9][a-z0-9._-]{0,99}$/,
  description:
    "the metric (requests, requests.route, rules, refused, top.refused, …)",
});

/** A dimension's value in a filter. */
const DimValue = s.string({ min: 1, max: 200 });

/** The dimension filters every counter read takes: each narrows to rows with that value. */
const dimFilters = {
  action: s.optional(DimValue),
  route: s.optional(DimValue),
  rule: s.optional(DimValue),
  country: s.optional(DimValue),
  asn: s.optional(DimValue),
  kind: s.optional(
    s.enum(["ip", "user", "username", "apiKey"], "a subject metric's kind"),
  ),
  subject: s.optional(DimValue),
  dryRun: s.optional(s.enum(["true", "false"], "a rule's dry run")),
  class: s.optional(DimValue),
  le: s.optional(DimValue),
  what: s.optional(DimValue),
  reason: s.optional(DimValue),
  cap: s.optional(DimValue),
} as const;

/** The names {@link dimFilters} takes. */
export const DIM_FILTER_NAMES = Object.keys(
  dimFilters,
) as readonly (keyof typeof dimFilters)[];

/** `GET /analytics/series`' query. */
export const SeriesQuery = s.query({
  scope: s.optional(Scope),
  metric: Metric,
  from: s.int({ min: 0, description: "the range's start (ms)" }),
  to: s.int({ min: 1, description: "the range's end, exclusive (ms)" }),
  tier: s.optional(
    s.enum(["minute", "hour", "day"], "the tier read (default by the range)"),
  ),
  ...dimFilters,
});

/** `GET /analytics/top`'s query. */
export const TopQuery = s.query({
  scope: s.optional(Scope),
  metric: Metric,
  from: s.int({ min: 0, description: "the range's start (ms)" }),
  to: s.int({ min: 1, description: "the range's end, exclusive (ms)" }),
  tier: s.optional(
    s.enum(["minute", "hour", "day"], "the tier read (default by the range)"),
  ),
  limit: s.optional(
    s.int({
      min: 1,
      max: ANALYTICS_READ_LIMITS.topN,
      description: `how many (default 10, at most ${ANALYTICS_READ_LIMITS.topN})`,
    }),
  ),
  ...dimFilters,
});

/** `GET /analytics/events`' query. */
export const EventsQuery = s.query({
  scope: s.optional(Scope),
  limit: s.optional(
    s.int({
      min: 1,
      max: ANALYTICS_READ_LIMITS.eventsPage,
      description: `the page size (default 50, at most ${ANALYTICS_READ_LIMITS.eventsPage})`,
    }),
  ),
  cursor: s.optional(
    s.string({ max: 4_000, description: "the previous page's next" }),
  ),
  direction: s.optional(
    s.enum(["asc", "desc"], "newest first (desc, the default) or oldest first"),
  ),
  from: s.optional(
    s.int({ min: 0, description: "only events at or after (ms)" }),
  ),
  to: s.optional(s.int({ min: 0, description: "only events before (ms)" })),
  action: s.optional(DimValue),
  rule: s.optional(DimValue),
  route: s.optional(DimValue),
  ip: s.optional(DimValue),
  country: s.optional(DimValue),
  asn: s.optional(s.int({ min: 0 })),
  dryRun: s.optional(s.boolean("dry-run hits only, or enforced only")),
  user: s.optional(DimValue),
  username: s.optional(DimValue),
  apiKey: s.optional(DimValue),
});

/** `GET /analytics/events/:id`'s parameters. */
export const EventParams = s.object({
  id: s.string({ min: 1, max: 64, description: "the event's id" }),
});

/** An event as the reader may see it. */
export const EventView: Schema<SecurityEventViewDto> = s.object({
  id: s.string(),
  at: s.int({ min: 0 }),
  service: s.string(),
  action: s.string(),
  rule: s.optional(s.string()),
  rules: s.optional(s.array(s.string(), 50)),
  dryRun: s.optional(s.boolean()),
  route: s.optional(s.string()),
  subjects: s.optional(
    s.object({
      ip: s.optional(s.string()),
      user: s.optional(s.string()),
      apiKey: s.optional(s.string()),
      username: s.optional(s.string()),
    }),
  ),
  country: s.optional(s.string()),
  asn: s.optional(s.int({ min: 0 })),
  latencyMs: s.optional(s.number({ min: 0 })),
  status: s.optional(s.int({ min: 100, max: 999 })),
  sampleRate: s.optional(
    s.number({
      min: 0,
      max: 1,
      description: "on a sampled allow: the share of allows kept",
    }),
  ),
  sample: s.optional(s.json("the redacted request (events:read)")),
});

/** A page of events. */
export const EventPage = s.object({
  items: s.array(EventView, ANALYTICS_READ_LIMITS.eventsPage),
  next: s.optional(s.string()),
  totalEstimate: s.optional(s.int({ min: 0 })),
});

/** A series' point. */
const Point: Schema<AnalyticsPointDto> = s.object({
  at: s.int({ min: 0 }),
  dims: s.record(s.string(), 8),
  value: s.int({ min: 0 }),
});

/** `GET /analytics/series`' answer. */
export const Series = s.object({
  tier: s.enum(["minute", "hour", "day"], "the tier read"),
  points: s.array(Point, ANALYTICS_READ_LIMITS.seriesPoints),
});

/** A top-N row. */
const TopRow: Schema<AnalyticsTopRowDto> = s.object({
  dims: s.record(s.string(), 8),
  value: s.int({ min: 0 }),
});

/** `GET /analytics/top`'s answer. */
export const Top = s.object({
  rows: s.array(TopRow, ANALYTICS_READ_LIMITS.topN),
});

/** `GET /live`'s query. */
export const LiveQuery = s.query({
  topics: s.optional(
    s.array(s.string({ min: 1, max: 100 }), LIVE_LIMITS.topicsPerConnection),
  ),
  resume: s.optional(
    s.string({
      max: 40,
      pattern: /^[\da-f]{1,32}:\d{1,15}$/,
      description: "<epoch>:<seq> to resume after (or Last-Event-ID)",
    }),
  ),
});

/** A live activity-feed event. */
export const LiveEventMessage: Schema<LiveEventMessageDto> = s.object({
  topic: s.string(),
  epoch: s.string(),
  seq: s.int({ min: 1 }),
  event: EventView,
});

/** A second's overview. */
export const LiveOverview: Schema<LiveOverviewDto> = s.object({
  topic: s.string(),
  at: s.int({ min: 0 }),
  requests: s.record(s.int({ min: 0 }), 20),
});

/** Events past the rate, counted. */
export const LiveMore: Schema<LiveMoreDto> = s.object({
  topic: s.string(),
  at: s.int({ min: 0 }),
  count: s.int({ min: 1 }),
});

/** A gap. */
export const LiveGap: Schema<LiveGapDto> = s.object({
  reason: s.enum(["resume", "slow"], "why messages were missed"),
  epoch: s.string(),
  seq: s.int({ min: 0 }),
});

/** A ban written or lifted, on `bans:<scope>`. */
export const LiveBan: Schema<LiveBanMessageDto> = s.object({
  topic: s.string(),
  epoch: s.string(),
  seq: s.int({ min: 1 }),
  ban: Ban,
});

/** `GET /analytics/bans`' query. */
export const BanTimelineQuery = s.query({
  scope: s.optional(Scope),
  from: s.int({ min: 0, description: "the range's start (ms)" }),
  to: s.int({ min: 1, description: "the range's end, exclusive (ms)" }),
  bucket: s.optional(
    s.enum(
      ["minute", "hour", "day"],
      "the bucket's width (default by the range)",
    ),
  ),
});

/** `GET /analytics/bans`' answer. */
export const BanTimeline: Schema<BanTimelineDto> = s.object({
  bucketMs: s.int({ min: 1 }),
  points: s.array(
    s.object({
      at: s.int({ min: 0 }),
      created: s.record(s.int({ min: 0 }), 4),
      lifted: s.int({ min: 0 }),
    }),
    ANALYTICS_READ_LIMITS.seriesPoints,
  ),
  active: s.int({ min: 0 }),
  truncated: s.boolean(),
});

/** A subscription's answer. */
export const LiveSubscribed: Schema<LiveSubscribedDto> = s.object({
  topics: s.array(s.string(), LIVE_LIMITS.topicsPerConnection),
  refused: s.array(
    s.object({
      topic: s.string(),
      reason: s.enum(["forbidden", "invalid", "limit"], "why"),
    }),
    100,
  ),
  epoch: s.string(),
  seq: s.int({ min: 0 }),
});

/** A control event (policy, bundle, approval, break-glass) with its place in the stream. */
export const LiveControl: Schema<LiveControlMessageDto> = s.object({
  event: s.enum(
    [
      "policy.published",
      "bundle.compiled",
      "approval.created",
      "approval.decided",
      "breakGlass.used",
      "ban.changed",
    ],
    "what happened",
  ),
  scope: s.string(),
  data: s.anyObject("what happened"),
  at: s.int({ min: 0 }),
  topic: s.optional(s.string()),
  epoch: s.string(),
  seq: s.int({ min: 1 }),
});

/** A channel's `subscribe` frame. */
export const SubscribeFrame = s.object({
  topics: s.array(
    s.string({ min: 1, max: 100 }),
    LIVE_LIMITS.topicsPerConnection,
  ),
  resume: s.optional(
    s.object({
      epoch: s.string({ max: 32 }),
      seq: s.int({ min: 0 }),
    }),
  ),
});

/** A channel's `unsubscribe` frame. */
export const UnsubscribeFrame = s.object({
  topics: s.array(
    s.string({ min: 1, max: 100 }),
    LIVE_LIMITS.topicsPerConnection,
  ),
});
