/**
 * `@kingsleyweb/bun-security/analytics`: events and analytics (README §8,
 * PR-CP1).
 *
 * At an enforcement point:
 * - {@link createAnalyticsRecorder}: per-minute counters, exact refusals per
 *   subject per day, and each minute's top-K, in bounded memory;
 * - {@link createEventRing}: the decisions worth an event, sampled and
 *   capped; {@link createRedactor}: what of a request an event may keep;
 * - {@link analyticsHook}: the three on `createSecurity`'s `onDecision`;
 * - {@link AgentEventBatch}: what an agent posts to `/agent/events` (its
 *   batcher is PR-CP4's).
 *
 * At the control plane:
 * - {@link decodeEventBatch} and {@link ingestEventBatch}: a posted batch
 *   decoded within its bounds and stored once;
 * - {@link analyticsMaintenance}: rollups and retention, on a timer or a
 *   bun-jobs schedule.
 */
import type { Decision } from "../engine/decision";
import type { RequestFacts } from "../engine/facts";
import type { AnalyticsRecorder } from "./recorder";
import type { Redactor } from "./redact";
import type { EventRing } from "./ring";

export {
  type AgentEventBatch,
  decodeEventBatch,
  EVENT_BATCH_FORMAT,
  EVENT_BATCH_LIMITS,
  EventBatchError,
  ingestEventBatch,
} from "./batch";
export {
  type AnalyticsMaintenance,
  analyticsMaintenance,
  type AnalyticsMaintenanceOptions,
  DEFAULT_RETENTION,
  MAX_RETENTION,
  type MaintenanceReport,
} from "./maintenance";
export {
  ANALYTICS_METRICS,
  type AnalyticsRecord,
  type AnalyticsRecorder,
  type AnalyticsRecorderOptions,
  type AnalyticsRecorderStats,
  type AnalyticsSubjectKind,
  createAnalyticsRecorder,
  type DecisionExtras,
  LATENCY_BUCKETS_MS,
  OTHER,
  REFUSING_ACTIONS,
} from "./recorder";
export {
  createRedactor,
  CREDENTIAL_HEADERS,
  looksLikeCredential,
  REDACTED,
  REDACTED_SEGMENT,
  REDACTION_LIMITS,
  type RedactionOptions,
  type Redactor,
  type RequestSample,
  type SampleInput,
  SENSITIVE_KEY_WORDS,
  SENSITIVE_PROFILES,
  TRUNCATED,
} from "./redact";
export {
  createEventRing,
  DEFAULT_EVENT_CAPS,
  type EventCap,
  type EventCaps,
  type EventExtras,
  type EventRing,
  type EventRingOptions,
  type OfferResult,
} from "./ring";
export { SpaceSaving, type SpaceSavingEntry } from "./spaceSaving";

/** What {@link analyticsHook} feeds. */
export interface AnalyticsHookOptions {
  /** The counters. */
  readonly recorder: AnalyticsRecorder;
  /** The events. */
  readonly ring: EventRing;
  /** The redaction of each event's sample. Default: none kept (no `sample`). */
  readonly redactor?: Redactor;
}

/**
 * `createSecurity({ onDecision })`'s analytics: each decision counted, and
 * offered to the ring with a redacted sample of what the facts hold (the
 * method, the path or the route's template, the query, the headers; never a
 * body, which the facts do not carry).
 */
export function analyticsHook(
  options: AnalyticsHookOptions,
): (decision: Decision, facts: RequestFacts) => void {
  const { recorder, ring, redactor } = options;
  return (decision, facts) => {
    const route = facts.routeKey;
    recorder.recordDecision(decision, route === undefined ? {} : { route });
    const template = route?.replace(/^\S+\s+/, "");
    ring.offer(decision, {
      ...(route === undefined ? {} : { route }),
      ...(redactor === undefined
        ? {}
        : {
            sample: redactor.sample({
              method: facts.method,
              path: facts.rawPath,
              ...(facts.query === undefined ? {} : { query: facts.query }),
              ...(template === undefined ? {} : { routeTemplate: template }),
              ...(facts.profile === undefined
                ? {}
                : { profile: facts.profile }),
              headers: facts.headers,
            }),
          }),
    });
  };
}
