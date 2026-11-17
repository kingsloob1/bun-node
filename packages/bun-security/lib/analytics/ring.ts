/**
 * An enforcement point's event ring (README §8.1, control-plane.md §9, the
 * user's caps of 2026-11-17): the decisions worth an event, sampled and
 * capped so an attack's volume cannot become the store's, held in bounded
 * memory until a batch takes them.
 *
 * - Every non-`allow` decision is offered; an `allow` is kept one time in a
 *   thousand (`sampleAllows`).
 * - At most 10 events a minute per subject and rule, 30 per subject, and
 *   600 per rule at this enforcement point; at most `maxEventsPerDay` a day.
 *   Past any cap the request is only counted (its counters are the
 *   recorder's), and the drop is counted under its cap: `events.capped
 *   { cap }`, with an `events.capped` warning at most once a minute per
 *   cap.
 * - The ring holds `capacity` events; past it the oldest is dropped and
 *   counted (`events.dropped { reason: "ring" }`).
 *
 * Subjects are the decision's, already keyed: the address key and the
 * HMACs of the API key id, the username and the user id (S7, S11, #842).
 */
import type { LoggerLike } from "@kingsleyweb/bun-common";
import type { Decision, SubjectKeys } from "../engine/decision";
import type { SecurityEvent, SecurityEventSubjects } from "../store/types";
import type { AnalyticsRecorder } from "./recorder";
import type { RequestSample } from "./redact";
import { ConfigError, resolveLogger } from "@kingsleyweb/bun-common";
import { scrubRule } from "./scrub";

/** The caps' names, as counted. */
export type EventCap = "subject-rule" | "subject" | "rule" | "day" | "tracking";

/** The ring's caps. */
export interface EventCaps {
  /** Events a minute per subject and rule. */
  readonly subjectRule: number;
  /** Events a minute per subject. */
  readonly subject: number;
  /** Events a minute per rule at one enforcement point. */
  readonly rule: number;
  /** Events a day at one enforcement point. */
  readonly day: number;
}

/** The caps' defaults (control-plane.md §9, the user's decision of 2026-11-17). */
export const DEFAULT_EVENT_CAPS: EventCaps = Object.freeze({
  /** Events a minute per subject and rule. */
  subjectRule: 10,
  /** Events a minute per subject. */
  subject: 30,
  /** Events a minute per rule at one enforcement point. */
  rule: 600,
  /** Events a day at one enforcement point (README §8.5's `maxEventsPerDay`). */
  day: 1_000_000,
});

/** Options of {@link createEventRing}. */
export interface EventRingOptions {
  /** The service: every event's. */
  readonly service: string;
  /** The most events held. Default 10,000 (control-plane.md §9). */
  readonly capacity?: number;
  /** The share of `allow` decisions kept, 0 to 1. Default 0.001. */
  readonly sampleAllows?: number;
  /** The caps; any left out default ({@link DEFAULT_EVENT_CAPS}). */
  readonly caps?: Partial<EventCaps>;
  /** How many subjects the per-minute caps track; a new subject past it is capped as `tracking`. Default 100,000. */
  readonly maxTracked?: number;
  /** Where drops are counted (`events.dropped`, `events.capped`). */
  readonly recorder?: AnalyticsRecorder;
  /** The clock. Default `Date.now`. */
  readonly now?: () => number;
  /** A number in [0, 1). Default `Math.random`. */
  readonly random?: () => number;
  /** Where the `events.capped` warning goes. Default: the console. */
  readonly logger?: LoggerLike;
}

/** What an offered decision carries beside the decision. */
export interface EventExtras {
  /** When it was decided. Default: the ring's clock. */
  readonly at?: number;
  /** The route's key. */
  readonly route?: string;
  /** The client's country. */
  readonly country?: string;
  /** The client's autonomous system. */
  readonly asn?: number;
  /** The decision's latency, milliseconds. */
  readonly latencyMs?: number;
  /** The answer's status. */
  readonly status?: number;
  /** The redacted request (`createRedactor().sample(...)`). */
  readonly sample?: RequestSample;
}

/** What became of an offered decision. */
export type OfferResult = "kept" | "sampled-out" | `capped:${EventCap}`;

/** The ring; see the module's description. */
export interface EventRing {
  /** Offers a decision; answers what became of it. */
  readonly offer: (decision: Decision, extras?: EventExtras) => OfferResult;
  /** Takes at most `max` events, the oldest first. */
  readonly take: (max: number) => SecurityEvent[];
  /** Puts events back at the front (a batch that could not be built); the ring's bound still holds. */
  readonly giveBack: (events: readonly SecurityEvent[]) => void;
  /** How many events it holds. */
  readonly size: () => number;
}

/** A random 128-bit id, hex. */
function eventId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

/** The deciding rule: the first hit whose action is the decision's. */
function decidingHit(decision: Decision): Decision["hits"][number] | undefined {
  return (
    decision.hits.find(
      (hit) => (hit.wouldHaveBeen ?? hit.action) === decision.action,
    ) ?? decision.hits[0]
  );
}

/** The ring; see the module's description. */
export function createEventRing(options: EventRingOptions): EventRing {
  if (typeof options !== "object" || options === null) {
    throw new ConfigError("createEventRing(): options must be { service, … }");
  }
  const { service, recorder } = options;
  if (
    typeof service !== "string" ||
    service.length === 0 ||
    service.length > 64
  ) {
    throw new ConfigError(
      "createEventRing(): service must be 1 to 64 characters",
    );
  }
  const whole = (
    value: number | undefined,
    fallback: number,
    what: string,
  ): number => {
    const out = value ?? fallback;
    if (!Number.isSafeInteger(out) || out < 1) {
      throw new ConfigError(
        `createEventRing(): ${what} must be a positive whole number`,
      );
    }
    return out;
  };
  const capacity = whole(options.capacity, 10_000, "capacity");
  const maxTracked = whole(options.maxTracked, 100_000, "maxTracked");
  const caps = {
    subjectRule: whole(
      options.caps?.subjectRule,
      DEFAULT_EVENT_CAPS.subjectRule,
      "caps.subjectRule",
    ),
    subject: whole(
      options.caps?.subject,
      DEFAULT_EVENT_CAPS.subject,
      "caps.subject",
    ),
    rule: whole(options.caps?.rule, DEFAULT_EVENT_CAPS.rule, "caps.rule"),
    day: whole(options.caps?.day, DEFAULT_EVENT_CAPS.day, "caps.day"),
  };
  const sampleAllows = options.sampleAllows ?? 0.001;
  if (!(
    typeof sampleAllows === "number" &&
    sampleAllows >= 0 &&
    sampleAllows <= 1
  )) {
    throw new ConfigError(
      "createEventRing(): sampleAllows must be a share from 0 to 1",
    );
  }
  const now = options.now ?? Date.now;
  const random = options.random ?? Math.random;
  const logger = resolveLogger(options.logger);

  const events: SecurityEvent[] = [];
  let minute = -1;
  let day = -1;
  let today = 0;
  const perSubjectRule = new Map<string, number>();
  const perSubject = new Map<string, number>();
  const perRule = new Map<string, number>();
  /** The minute each cap last warned in. */
  const warned = new Map<EventCap, number>();

  const capped = (cap: EventCap, at: number): OfferResult => {
    recorder?.count("events.capped", { cap }, 1, at);
    const start = Math.floor(at / 60_000);
    if (warned.get(cap) !== start) {
      warned.set(cap, start);
      logger.warn("bun-security: events.capped", { service, cap });
    }
    return `capped:${cap}`;
  };

  const subjectsOf = (subject: SubjectKeys): SecurityEventSubjects => {
    const out: { -readonly [K in keyof SecurityEventSubjects]: string } = {};
    if (subject.ip !== undefined) out.ip = subject.ip;
    // Already keyed by the engine: the API key id's, the username's and the
    // user id's HMAC.
    if (subject.apiKey !== undefined) out.apiKey = subject.apiKey;
    if (subject.username !== undefined) out.username = subject.username;
    if (subject.user !== undefined) out.user = subject.user;
    return out;
  };

  const ring: EventRing = {
    offer: (decision, extras = {}) => {
      const at = extras.at ?? now();
      if (decision.action === "allow" && random() >= sampleAllows)
        return "sampled-out";
      const thisMinute = Math.floor(at / 60_000);
      if (thisMinute !== minute) {
        minute = thisMinute;
        perSubjectRule.clear();
        perSubject.clear();
        perRule.clear();
      }
      const thisDay = Math.floor(at / 86_400_000);
      if (thisDay !== day) {
        day = thisDay;
        today = 0;
      }
      const hit = decidingHit(decision);
      const rule =
        hit === undefined
          ? `(${decision.action})`
          : scrubRule(hit.rule, decision.subject);
      const subjects = subjectsOf(decision.subject);
      const subject =
        subjects.ip ??
        subjects.apiKey ??
        subjects.username ??
        subjects.user ??
        "(none)";
      const subjectRule = `${subject}\u0000${rule}`;
      if (today >= caps.day) return capped("day", at);
      if ((perRule.get(rule) ?? 0) >= caps.rule) return capped("rule", at);
      if (!perSubject.has(subject) && perSubject.size >= maxTracked)
        return capped("tracking", at);
      if ((perSubject.get(subject) ?? 0) >= caps.subject)
        return capped("subject", at);
      if ((perSubjectRule.get(subjectRule) ?? 0) >= caps.subjectRule) {
        return capped("subject-rule", at);
      }
      perRule.set(rule, (perRule.get(rule) ?? 0) + 1);
      perSubject.set(subject, (perSubject.get(subject) ?? 0) + 1);
      if (perSubjectRule.size < maxTracked || perSubjectRule.has(subjectRule)) {
        perSubjectRule.set(
          subjectRule,
          (perSubjectRule.get(subjectRule) ?? 0) + 1,
        );
      }
      today += 1;
      const dryRun = hit?.wouldHaveBeen !== undefined;
      events.push(
        Object.freeze({
          id: eventId(),
          at,
          service,
          action: decision.action,
          ...(hit === undefined ? {} : { rule }),
          ...(decision.hits.length === 0
            ? {}
            : {
                rules: decision.hits
                  .slice(0, 50)
                  .map((h) => scrubRule(h.rule, decision.subject)),
              }),
          ...(dryRun ? { dryRun } : {}),
          ...(extras.route === undefined ? {} : { route: extras.route }),
          ...(Object.keys(subjects).length === 0 ? {} : { subjects }),
          ...(extras.country === undefined ? {} : { country: extras.country }),
          ...(extras.asn === undefined ? {} : { asn: extras.asn }),
          ...(extras.latencyMs === undefined
            ? {}
            : { latencyMs: extras.latencyMs }),
          ...(extras.status === undefined ? {} : { status: extras.status }),
          ...(decision.action === "allow" ? { sampleRate: sampleAllows } : {}),
          ...(extras.sample === undefined ? {} : { sample: extras.sample }),
        }),
      );
      if (events.length > capacity) {
        events.shift();
        recorder?.count("events.dropped", { reason: "ring" }, 1, at);
      }
      return "kept";
    },
    take: (max) => events.splice(0, Math.max(0, max)),
    giveBack: (taken) => {
      events.unshift(...taken);
      const over = events.length - capacity;
      if (over > 0) {
        events.splice(0, over);
        recorder?.count("events.dropped", { reason: "ring" }, over);
      }
    },
    size: () => events.length,
  };
  return Object.freeze(ring);
}
